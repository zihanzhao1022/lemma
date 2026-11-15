import React from 'react';

/** The product's name, in one place. Phrases name it through `{name}`. */
export const NAME = 'OnizukaTex';

const SERIF = "'Source Serif 4', 'Source Serif Pro', Georgia, serif";

/** The app's mark: an O with a small T tucked into its corner, the way the LaTeX logo tucks its A in after the L. */
export const Mark: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <rect x="1" y="1" width="62" height="62" rx="15" fill="white" stroke="#e4e4e7" strokeWidth="2" />
    <text x="9" y="46" fontFamily={SERIF} fontWeight="700" fontSize="36" fill="#1d1d1f">
      O
    </text>
    <text x="35" y="35" fontFamily={SERIF} fontWeight="700" fontSize="24" fill="#6d28d9">
      T
    </text>
  </svg>
);

/** The name: Onizuka, then TeX set as its logo is, the E dropped below the line (see .brand-wordmark). */
export const Wordmark: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span className={`flex items-center gap-2 ${className}`}>
    <Mark />
    <span className="brand-wordmark text-xl" aria-hidden="true">
      <span>Onizuka</span>
      <span className="tex">
        <span>T</span>
        <span className="e">E</span>
        <span>X</span>
      </span>
    </span>
  </span>
);
