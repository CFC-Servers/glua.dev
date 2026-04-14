import type { StreamParser, StringStream } from "@codemirror/language";

interface LuaState {
  basecol: number;
  indentDepth: number;
  cur: (stream: StringStream, state: LuaState) => string | null;
}

const keywords = /^(and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)$/;
const builtins = /^(_G|assert|collectgarbage|dofile|error|getfenv|getmetatable|ipairs|load|loadfile|loadstring|module|next|pairs|pcall|print|rawequal|rawget|rawset|require|select|setfenv|setmetatable|tonumber|tostring|type|unpack|xpcall|coroutine|table|io|os|string|math|debug|package)$/;
const specials = /^(self|\.\.\.|_VERSION)$/;
const indentTokens = /^(do|function|for|if|repeat|while)$/;
const dedentTokens = /^(end|until)$/;
const dedentPartial = /^(end|until|else|elseif)\b/;
const indentUnit = 2;

function normal(stream: StringStream, state: LuaState): string | null {
  const ch = stream.next();
  if (ch == null) return null;

  if (ch === "-" && stream.eat("-")) {
    if (stream.eat("[") && stream.eat("[")) return longString(stream, state, "comment");
    stream.skipToEnd();
    return "comment";
  }
  if (ch === "\"" || ch === "'") return string(ch)(stream, state);
  if (ch === "[" && /[\[=]/.test(stream.peek() ?? "")) return longString(stream, state, "string");
  if (/\d/.test(ch)) {
    stream.eatWhile(/[\w.%]/);
    return "number";
  }
  if (/[\w_]/.test(ch)) {
    stream.eatWhile(/[\w_]/);
    return "variable";
  }
  if (ch === "<" || ch === ">") {
    stream.eat("=");
    return "operator";
  }
  if ((ch === "=" || ch === "~" || ch === ":") && stream.eat("=")) {
    return "operator";
  }
  if (/[{}(\[\].,;]/.test(ch)) return "bracket";
  return "operator";
}

function string(quote: string) {
  return (stream: StringStream, state: LuaState): string => {
    let escaped = false;
    let ch: string | null;
    while ((ch = stream.next()) != null) {
      if (ch === quote && !escaped) break;
      escaped = !escaped && ch === "\\";
    }
    if (!escaped) state.cur = normal;
    return "string";
  };
}

function longString(stream: StringStream, state: LuaState, style: string): string {
  stream.eatWhile(/=/);
  const level = stream.current().length;
  if (!stream.eat("[")) return style;
  state.cur = (s: StringStream, st: LuaState) => {
    const stop = "]" + "=".repeat(level) + "]";
    let ch: string | null;
    while ((ch = s.next()) != null) {
      if (ch === "]" && s.current().slice(-stop.length) === stop) {
        st.cur = normal;
        break;
      }
    }
    return style;
  };
  return style;
}

export const lua: StreamParser<LuaState> = {
  name: "lua",
  startState: () => ({ basecol: 0, indentDepth: 0, cur: normal }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    let style = state.cur(stream, state);
    const word = stream.current();
    if (style === "variable") {
      if (keywords.test(word)) style = "keyword";
      else if (builtins.test(word)) style = "builtin";
      else if (specials.test(word)) style = "variable-2";
    }
    if (style !== "comment" && style !== "string") {
      if (indentTokens.test(word)) ++state.indentDepth;
      else if (dedentTokens.test(word)) --state.indentDepth;
    }
    return style;
  },
  indent(state, textAfter) {
    const closing = dedentPartial.test(textAfter);
    return state.basecol + indentUnit * (state.indentDepth - (closing ? 1 : 0));
  },
  languageData: {
    commentTokens: { line: "--", block: { open: "--[[", close: "]]" } },
    closeBrackets: { brackets: ["(", "[", "{", "'", "\""] },
    indentOnInput: /^\s*(?:end|else|elseif|until)\s*$/,
  },
};
