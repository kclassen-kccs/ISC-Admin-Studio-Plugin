import { useState } from "react";
import { Percent, ArrowDownToLine, ArrowUpFromLine, Copy } from "lucide-react";
import toast from "react-hot-toast";
import { TopBar } from "../../components/TopBar";
import { ToolsTitleMenu } from "../../components/ToolsTitleMenu";
import { OutlineButton } from "../../components/ui";

// Percent-encoding per the tool's spec: special URL characters become a
// percent sign plus two hex digits of the character's codepoint bytes
// (space → %20, colon → %3a, slash → %2f), lowercase hex, non-special
// characters unchanged. With encodeAll, EVERY character is converted —
// each UTF-8 byte to its %xx form.
function urlEncode(s, encodeAll) {
  if (!encodeAll) {
    return encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  }
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += "%" + b.toString(16).padStart(2, "0");
  return out;
}

function urlDecode(s) {
  return decodeURIComponent(s);
}

export default function UrlEncodePage() {
  const [input, setInput] = useState("");
  const [encodeAll, setEncodeAll] = useState(false);
  const [output, setOutput] = useState(null); // { label, text } | { error }

  function run(mode) {
    try {
      const text = mode === "encode" ? urlEncode(input, encodeAll) : urlDecode(input);
      setOutput({ label: mode === "encode" ? "Encoded" : "Decoded", text });
    } catch {
      setOutput({ error: "The input isn't valid percent-encoding." });
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<ToolsTitleMenu active="URL Encode" />} />
      <div className="flex-1 overflow-y-auto pb-24 px-4 py-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
            <Percent size={18} className="text-slate-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">URL Encode</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Converts special URL characters to percent-encoding — each character's codepoint as a percent
              sign plus two hex digits (space → %20, colon → %3a, slash → %2f). Runs entirely in your browser.
            </p>
          </div>
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste or type the input string…"
          rows={10}
          spellCheck={false}
          className="w-full bg-white border border-gray-200 rounded-xl px-3 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition font-mono"
        />

        <label className="flex items-start gap-2 mt-3 cursor-pointer">
          <input
            type="checkbox"
            checked={encodeAll}
            onChange={(e) => setEncodeAll(e.target.checked)}
            className="w-4 h-4 mt-0.5 rounded border-gray-300 accent-blue-600"
          />
          <span className="text-sm text-gray-700">
            Encode non-special characters
            <span className="block text-xs text-gray-400">
              Convert every character to percent-encoding, not just the special ones. Affects Encode only.
            </span>
          </span>
        </label>

        <div className="flex gap-2 mt-3">
          <OutlineButton onClick={() => run("encode")} disabled={!input} className="!w-auto flex-1">
            <ArrowDownToLine size={16} />
            Encode
          </OutlineButton>
          <OutlineButton onClick={() => run("decode")} disabled={!input} className="!w-auto flex-1">
            <ArrowUpFromLine size={16} />
            Decode
          </OutlineButton>
        </div>

        {output && (
          <div className="mt-4">
            {output.error ? (
              <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Error</p>
                <p className="text-sm text-red-700">{output.error}</p>
              </div>
            ) : (
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{output.label}</p>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(output.text); toast.success("Copied"); }}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                  >
                    <Copy size={13} />
                    Copy
                  </button>
                </div>
                <pre className="px-4 py-3 text-sm text-gray-900 font-mono whitespace-pre-wrap break-all max-h-[50vh] overflow-y-auto">
                  {output.text || <span className="text-gray-400 italic">(empty)</span>}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
