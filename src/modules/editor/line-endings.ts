import { Facet, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

const initialEndings = Facet.define<Text, Text>({ combine: values => values[0] ?? Text.empty });
const preferredEnding = Facet.define<string, string>({ combine: values => values[0] ?? "L" });
const restoreEndings = StateEffect.define<Text>();
/** One persistent code per newline preserves mixed LF/CRLF/CR through edits and undo. */
export const lineEndings = StateField.define<Text>({
  create: state => state.facet(initialEndings),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(restoreEndings)) return effect.value;
    if (!transaction.docChanged) return value;
    let shift = 0;
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const start = transaction.startState.doc.lineAt(fromA).number - 1;
      const end = transaction.startState.doc.lineAt(toA).number - 1;
      const count = inserted.lines - 1;
      if (start === end && count === 0) return;
      const codes = Array(count).fill(transaction.startState.facet(preferredEnding));
      value = value.replace((start + shift) * 2, (end + shift) * 2, Text.of([...codes, ""]));
      shift += count - (end - start);
    });
    return value;
  }
});
export function preserveLineEndings(endings: Text, preferred: string): Extension {
  return [initialEndings.of(endings), preferredEnding.of(preferred === "\r\n" ? "C" : preferred === "\r" ? "R" : "L"), lineEndings,
    invertedEffects.of(transaction => transaction.docChanged ? [restoreEndings.of(transaction.startState.field(lineEndings))] : [])];
}
