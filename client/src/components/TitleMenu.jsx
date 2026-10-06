import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";

// Generic screen-title dropdown — turns the TopBar title into a menu for
// jumping between a related set of screens (used by Browse and Role Mining).
export function TitleMenu({ active, items }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 -ml-1 px-1 py-0.5 rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors"
      >
        <h1 className="text-base font-semibold text-gray-900 truncate leading-tight">
          {active}
        </h1>
        <ChevronDown size={16} className={`text-gray-400 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg py-1 z-30">
          {items.map(({ path, label, Icon }) => {
            const isActive = label === active;
            return (
              <button
                key={path}
                onClick={() => {
                  setOpen(false);
                  if (!isActive) navigate(path);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                  isActive ? "text-blue-600 font-medium bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <Icon size={16} strokeWidth={isActive ? 2.5 : 1.8} />
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
