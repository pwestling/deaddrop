import { Layers2 } from "lucide-react";
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Layers2 size={21} strokeWidth={1.8} />
      </span>
      <span>
        deaddrop<span className="brand-period">.</span>
      </span>
    </div>
  );
}
