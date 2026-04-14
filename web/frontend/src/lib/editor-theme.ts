import { EditorView } from "@codemirror/view";

export const gluaTheme = EditorView.theme(
  {
    "&": { color: "#d1d5db", backgroundColor: "#1F2937" },
    ".cm-content": { caretColor: "#60a5fa" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#60a5fa" },
    "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#3b82f680" },
    ".cm-gutters": { backgroundColor: "#1F2937", color: "#6b7280", border: "none" },
  },
  { dark: true }
);
