import subprocess
from pathlib import Path

from aws_cdk import (
    App,
    Duration,
    Environment,
    Stack,
    aws_certificatemanager as acm,
    aws_ec2 as ec2,
    aws_elasticloadbalancingv2 as elbv2,
    aws_elasticloadbalancingv2_targets as tgt,
    aws_iam as iam,
    aws_route53 as route53,
)
from constructs import Construct

REPO_URL = "https://github.com/LukeKeywalker/gud-mud.git"
DOMAIN = "mud.michniewicz.contact"
ZONE_ID = "Z08775041GRCKGXJFLFZW"
ZONE_NAME = "michniewicz.contact."
HOST_PORT = 18000
INSTANCE_NAME = "mud-game"
AMZ_OWNER = "099720109477"


def current_account() -> str:
    import boto3
    return boto3.client("sts").get_caller_identity()["Account"]


def pinned_sha() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()


def render_user_data(sha: str) -> ec2.UserData:
    template = Path(__file__).resolve().parent / "scripts" / "user-data.sh"
    text = template.read_text().replace("__REPO__", REPO_URL).replace("__SHA__", sha)
    if len(text.encode("utf-8")) > 16 * 1024:
        raise RuntimeError("rendered user-data exceeds CloudFormation 16KB limit")
    return ec2.UserData.custom(text)


class MudDemoStack(Stack):
    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        vpc = ec2.Vpc(self, "Vpc", max_azs=2, nat_gateways=0)
        inst_sg = ec2.SecurityGroup(self, "InstanceSecurityGroup", vpc=vpc,
                                    description="MUD game instance")
        alb_sg = ec2.SecurityGroup(self, "AlbSecurityGroup", vpc=vpc,
                                   description="MUD game ALB")

        cert = acm.Certificate(
            self, "Certificate", domain_name=DOMAIN,
            validation=acm.CertificateValidation.from_dns())

        tg = elbv2.ApplicationTargetGroup(
            self, "GameTargetGroup",
            port=HOST_PORT,
            protocol=elbv2.ApplicationProtocol.HTTP,
            vpc=vpc,
            health_check=elbv2.HealthCheck(
                path="/healthz",
                interval=Duration.seconds(15),
                healthy_threshold_count=2,
                unhealthy_threshold_count=3,
            ),
        )

        alb = elbv2.ApplicationLoadBalancer(
            self, "LoadBalancer",
            vpc=vpc,
            internet_facing=True,
            security_group=alb_sg,
        )
        alb.add_listener("Https", port=443,
                         certificates=[cert],
                         default_target_groups=[tg])
        alb.add_redirect(target_port=443,
                         target_protocol=elbv2.ApplicationProtocol.HTTPS)

        role = iam.Role(
            self, "InstanceRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_managed_policy_arn(
                    self, "SsmManagedPolicy",
                    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"),
            ],
        )

        instance = ec2.Instance(
            self, "GameInstance",
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
            instance_type=ec2.InstanceType("t4g.micro"),
            instance_name=INSTANCE_NAME,
            machine_image=ec2.MachineImage.lookup(
                name="ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
                owners=[AMZ_OWNER],
                filters={
                    "root-device-type": ["ebs"],
                    "virtualization-type": ["hvm"],
                    "state": ["available"],
                },
            ),
            role=role,
            security_group=inst_sg,
            associate_public_ip_address=True,
            user_data=render_user_data(pinned_sha()),
        )
        tg.add_target(tgt.InstanceTarget(instance))
        inst_sg.add_ingress_rule(
            alb_sg, ec2.Port.tcp(HOST_PORT), description="ALB -> game host port")

        zone = route53.PublicHostedZone.from_hosted_zone_attributes(
            self, "Zone",
            hosted_zone_id=ZONE_ID,
            zone_name=ZONE_NAME,
        )
        for rec_type in ("A", "AAAA"):
            route53.CfnRecordSet(
                self, f"MudRecord{rec_type}",
                hosted_zone_id=zone.hosted_zone_id,
                name=DOMAIN + ".",
                type=rec_type,
                alias_target=route53.CfnRecordSet.AliasTargetProperty(
                    dns_name=alb.load_balancer_dns_name,
                    hosted_zone_id=alb.load_balancer_canonical_hosted_zone_id,
                ),
            )


if __name__ == "__main__":
    app = App()
    MudDemoStack(
        app, "MudDemo",
        env=Environment(account=current_account(), region="eu-north-1"))
    app.synth()
