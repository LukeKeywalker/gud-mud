from aws_cdk import App, Environment, Stack
from constructs import Construct


class MudDemoStack(Stack):
    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)


if __name__ == "__main__":
    app = App()
    MudDemoStack(app, "MudDemo", env=Environment(region="eu-north-1"))
    app.synth()
