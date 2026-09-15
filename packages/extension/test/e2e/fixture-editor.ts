import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

const schema = new Schema({ nodes: basic.spec.nodes, marks: basic.spec.marks });

const mount = document.getElementById("pm-editor");
if (mount !== null) {
  // The fixture server has already substituted the token into `data-text`.
  const text = mount.getAttribute("data-text") ?? "";
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
  const view = new EditorView(mount, { state: EditorState.create({ doc, schema }) });
  (window as unknown as { __pmView: EditorView }).__pmView = view;
}
