// Inline SVG-иконки чата (внешних icon-библиотек в проекте нет — новых зависимостей не добавляем).

function base(className: string) {
  return {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    'aria-hidden': true as const,
  };
}

export function SearchIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function ArrowLeftIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m7-7l-7 7 7 7" />
    </svg>
  );
}

export function MoreVerticalIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SendIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export function MicIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3" />
    </svg>
  );
}

export function SmileIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M8.5 14.5s1.2 2 3.5 2 3.5-2 3.5-2" />
      <circle cx="9" cy="9.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PaperclipIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8L13 5a3.7 3.7 0 015.2 5.2l-8.2 8.2a1.85 1.85 0 01-2.6-2.6L14.5 8.7"
      />
    </svg>
  );
}

export function CheckIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

export function CheckCheckIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12.5l4.5 4.5L16 7.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 15.5l1.5 1.5L21.5 8" />
    </svg>
  );
}

export function ChevronDownIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function AlertCircleIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M12 7.5V13" />
      <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MessageCircleIcon({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg {...base(className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a8 8 0 01-8 8H4l2-3a8 8 0 1115-5z" />
    </svg>
  );
}
