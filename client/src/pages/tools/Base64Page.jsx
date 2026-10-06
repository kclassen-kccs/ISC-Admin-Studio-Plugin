import { useState } from "react";
import { Binary, ArrowDownToLine, ArrowUpFromLine, Copy } from "lucide-react";
import toast from "react-hot-toast";
import { TopBar } from "../../components/TopBar";
import { ToolsTitleMenu } from "../../components/ToolsTitleMenu";
import { OutlineButton } from "../../components/ui";

// UTF-8-safe encode/decode — plain btoa/atob choke on any character
// outside Latin-1, and real-world payloads (JSON, names with accents)
// routinely contain them.
function encodeBase64(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function decodeBase64(s) {
  const cleaned = s.replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export default function Base64Page() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState(null); // { label, text } | { error }

  function run(mode) {
    try {
      const text = mode === "encode" ? encodeBase64(input) : decodeBase64(input);
      setOutput({ label: mode === "encode" ? "Encoded" : "Decoded", text });
    } catch (err) {
      setOutput({ error: mode === "decode" ? "The input isn't valid Base64." : err.message });
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<ToolsTitleMenu active="Base64" />} />
      <div className="flex-1 overflow-y-auto pb-24 px-4 py-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
            <Binary size={18} className="text-slate-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Base64</h2>
            <p className="text-xs text-gray-500 mt-0.5">Encode or decode text, entirely in your browser — nothing is sent anywhere.</p>
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

        <div className="flex gap-2 mt-3">
          <OutlineButton onClick={() => run("encode")} disabled={!input} className="!w-auto flex-1">
            <ArrowDownToLine size={16} />
            Base64 Encode
          </OutlineButton>
          <OutlineButton onClick={() => run("decode")} disabled={!input} className="!w-auto flex-1">
            <ArrowUpFromLine size={16} />
            Base64 Decode
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
