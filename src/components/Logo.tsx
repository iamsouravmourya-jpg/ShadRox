export function ShadRoxLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      {/* Outer modern geometric shield */}
      <path
        d="M6 7L16 3L26 7V16C26 22.5 16 29 16 29C16 29 6 22.5 6 16V7Z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* S-shaped glowing engineering glyph */}
      <path
        d="M20 11H13.5C12.1193 11 11 12.1193 11 13.5C11 14.8807 12.1193 16 13.5 16H18.5C19.8807 16 21 17.1193 21 18.5C21 19.8807 19.8807 21 18.5 21H11"
        stroke="#10b981"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="11" cy="11" r="1.5" fill="#34d399" />
      <circle cx="21" cy="21" r="1.5" fill="#34d399" />
    </svg>
  );
}

/** Legacy alias for backwards compatibility */
export const DevoraLogo = ShadRoxLogo;
