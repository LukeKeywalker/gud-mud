import { readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pyo = await loadPyodide();
pyo.FS.mkdirTree("/mud/game_core");
for (const [path, enc] of Object.entries(payload.files)) {
  pyo.FS.writeFile(path, Buffer.from(enc, "base64"));
}
pyo.FS.writeFile("/mud/mud.pkl", Buffer.from(payload.pkl, "base64"));
pyo.FS.writeFile("/mud/mud.log", Buffer.from(payload.log, "base64"));
const hash = pyo.runPython(`
import sys, pickle, json
sys.path.insert(0, "/mud")
from game_core import world as W
from game_core import moves as M
spec = pickle.loads(open("/mud/mud.pkl", "rb").read())
w = W.build_world(spec)
for pid in (1001, 1002, 1003):
    w.add_entity(W.Entity(pid, "p", 1, 2, 2, 0, 7, False))
for t, frames in json.loads(open("/mud/mud.log", "rb").read()):
    M.step(w, t, [M.InputFrame(*f) for f in frames])
W.state_hash(w).hex()
`);
console.log("HASH " + hash);
