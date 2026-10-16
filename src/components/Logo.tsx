export function DevoraLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        d="M6 6C6 4.89543 6.89543 4 8 4H16.5C22.299 4 27 8.70101 27 14.5C27 20.299 22.299 25 16.5 25H8C6.89543 25 6 24.1046 6 23V6Z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 10.5V19.5M12 10.5H16.5C18.9853 10.5 21 12.5147 21 15C21 17.4853 18.9853 19.5 16.5 19.5H12"
        stroke="#10b981"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="21" cy="15" r="1.5" fill="#34d399" />
    </svg>
  );
}
