function toWord(ch) {
  return /[\w_]/.test(ch) ? ch : " ";
}
var lua = {
  name: "lua",
  startState: function() {
    return {
      basecol: 0,
      indentDepth: 0,
      cur: normal
    };
  },
  token: function(stream, state) {
    if (stream.eatSpace())
      return null;
    var style = state.cur(stream, state);
    var word = stream.current();
    if (style == "variable") {
      if (keywords.test(word))
        style = "keyword";
      else if (builtins.test(word))
        style = "builtin";
      else if (specials.test(word))
        style = "variable-2";
    }
    if (style != "comment" && style != "string") {
      if (indentTokens.test(word))
        ++state.indentDepth;
      else if (dedentTokens.test(word))
        --state.indentDepth;
    }
    return style;
  },
  indent: function(state, textAfter) {
    var closing = dedentPartial.test(textAfter);
    return state.basecol + indentUnit * (state.indentDepth - (closing ? 1 : 0));
  },
  lineComment: "--",
  blockCommentStart: "--[[",
  blockCommentEnd: "]]",
  languageData: {
    closeBrackets: { brackets: ["(", "[", "{", "'", "\""] },
    commentTokens: {
      line: "--",
      block: { open: "--[[", close: "]]" }
    },
    indentOnInput: /^\s*(?:end|else|elseif|until)\s*$/
  }
};
function normal(stream, state) {
  var ch = stream.next();
  if (ch == "-" && stream.eat("-")) {
    if (stream.eat("[") && stream.eat("["))
      return longString(stream, state, "comment");
    stream.skipToEnd();
    return "comment";
  }
  if (ch == '"' || ch == "'")
    return string(ch)(stream, state);
  if (ch == "[" && /[[\[=]/.test(stream.peek()))
    return longString(stream, state, "string");
  if (/\d/.test(ch)) {
    stream.eatWhile(/[\w.%]/);
    return "number";
  }
  if (/[\w_]/.test(ch)) {
    stream.eatWhile(/[\w_]/);
    return "variable";
  }
  if (ch == "<" || ch == ">") {
    stream.eat("=");
    return "operator";
  }
  if (ch == "=" || ch == "~" || ch == ":") {
    if (stream.eat("="))
      return "operator";
  }
  if (/[{}(\[\].,;]/.test(ch))
    return "bracket";
  return "operator";
}
function string(quote) {
  return function(stream, state) {
    var escaped = false, ch;
    while ((ch = stream.next()) != null) {
      if (ch == quote && !escaped)
        break;
      escaped = !escaped && ch == "\\";
    }
    if (!escaped)
      state.cur = normal;
    return "string";
  };
}
function longString(stream, state, style) {
  var level = 0, found = false;
  stream.eatWhile(/=/);
  level = stream.current().length;
  if (!stream.eat("["))
    return style;
  return function(stream2, state2) {
    var ch, stop = "]" + "=".repeat(level) + "]";
    while ((ch = stream2.next()) != null) {
      if (ch == "]" && stream2.current().slice(-stop.length) == stop) {
        state2.cur = normal;
        found = true;
        break;
      }
    }
    return style;
  };
}
var keywords = new RegExp("^((" + [
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while"
].join(")|(") + "))$");
var builtins = new RegExp("^((" + [
  "_G",
  "assert",
  "collectgarbage",
  "dofile",
  "error",
  "getfenv",
  "getmetatable",
  "ipairs",
  "load",
  "loadfile",
  "loadstring",
  "module",
  "next",
  "pairs",
  "pcall",
  "print",
  "rawequal",
  "rawget",
  "rawset",
  "require",
  "select",
  "setfenv",
  "setmetatable",
  "tonumber",
  "tostring",
  "type",
  "unpack",
  "xpcall",
  "coroutine",
  "table",
  "io",
  "os",
  "string",
  "math",
  "debug",
  "package"
].join(")|(") + "))$");
var specials = new RegExp("^((" + [
  "self",
  "...",
  "_VERSION"
].join(")|(") + "))$");
var indentTokens = /^(do|function|for|if|repeat|while)$/;
var dedentTokens = /^(end|until)$/;
var dedentPartial = /^(end|until|else|elseif)\b/;
var indentUnit = 2;
export {
  lua
};
//# sourceMappingURL=lua.js.map
