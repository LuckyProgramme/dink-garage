export default function CourtArt({
  miniature = false,
}: {
  miniature?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 640 440"
      fill="none"
      aria-hidden="true"
      className={miniature ? "court-art miniature" : "court-art"}
    >
      <defs>
        <pattern
          id={miniature ? "tiny-grain" : "grain"}
          width="8"
          height="8"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".55" fill="#fff" opacity=".13" />
        </pattern>
      </defs>
      <path d="M22 292 308 85 622 246 337 456Z" fill="#163e38" opacity=".18" />
      <path d="M20 267 304 61 622 226 337 438Z" fill="#a5b4a0" />
      <path
        d="M64 259 306 85 576 227 335 405Z"
        fill="#286f64"
        stroke="#f5e9cf"
        strokeWidth="3"
      />
      <path d="M170 183 439 327 472 304 202 160Z" fill="#58917d" />
      <path
        d="M64 259 306 85 576 227 335 405Z"
        fill={`url(#${miniature ? "tiny-grain" : "grain"})`}
      />
      <path
        d="m169 184 270 144M201 160l271 144M199 330l104-75m34-23 105-75"
        stroke="#f5e9cf"
        strokeWidth="2.5"
      />
      <path d="M178 152 488 314" stroke="#e9dcc4" strokeWidth="3" />
      <path d="M178 121v58m310 107v57" stroke="#173e39" strokeWidth="5" />
      <path
        d="M180 126 486 288v25L180 151Z"
        fill="#173c36"
        opacity=".8"
        stroke="#e2d6ba"
        strokeWidth="1.5"
      />
      {Array.from({ length: 26 }, (_, i) => (
        <path
          key={i}
          d={`M${184 + i * 11.5} ${128 + i * 6.1}v22`}
          stroke="#b0bc9b"
          strokeWidth=".6"
        />
      ))}
      <path d="m182 137 302 160" stroke="#b0bc9b" strokeWidth=".7" />
      <ellipse cx="345" cy="326" rx="17" ry="8" fill="#153d36" opacity=".2" />
      <circle cx="339" cy="309" r="12" fill="#e8ed8c" />
      <circle cx="335" cy="305" r="2" fill="#a4b35b" />
      <circle cx="344" cy="307" r="2" fill="#a4b35b" />
      <circle cx="339" cy="314" r="2" fill="#a4b35b" />
    </svg>
  );
}
