export function WritingPanda() {
  return (
    <svg className="writing-panda" viewBox="0 0 180 120" role="img" aria-label="正在写作和寄信的小熊猫">
      <ellipse cx="84" cy="111" rx="61" ry="5" fill="#EFEFEF" />
      {/* A soft, oversized head rests over a small body and an open notebook. */}
      <path d="M43 72C34 86 37 101 51 106c18 8 48 7 62-2 13-9 9-26-2-34Z" fill="#292929" />
      <path d="M60 77c-9 12-10 26 3 30 11 4 30 3 38-3 8-8 2-22-8-28Z" fill="#FAFAFA" />
      <ellipse cx="42" cy="103" rx="14" ry="9" transform="rotate(-16 42 103)" fill="#292929" />
      <ellipse cx="114" cy="104" rx="13" ry="8" transform="rotate(12 114 104)" fill="#292929" />
      <g transform="rotate(-7 77 49)">
        <circle cx="42" cy="20" r="14" fill="#292929" />
        <circle cx="108" cy="20" r="14" fill="#292929" />
        <path d="M35 20q1-8 8-8m58 1q7-1 10 6" fill="none" stroke="#626262" strokeWidth="3" strokeLinecap="round" />
        <path d="M34 42C34 23 50 12 74 12c25-1 44 11 45 30 1 7 5 13 3 23-3 16-22 25-45 25-24 0-43-9-46-25-2-9 3-14 3-23Z" fill="#FFF" stroke="#353535" strokeWidth="1.8" />
        <path d="M37 69c9 11 23 15 41 15s33-5 40-15c-4 14-20 20-41 20-20 0-35-7-40-20Z" fill="#F0F0F0" />
        <path d="M67 14q4-5 8-3m-1 2q5-5 10-1" fill="#FFF" stroke="#353535" strokeWidth="1.8" strokeLinecap="round" />
        <ellipse cx="55" cy="50" rx="12" ry="15" transform="rotate(28 55 50)" fill="#292929" />
        <ellipse cx="98" cy="50" rx="12" ry="15" transform="rotate(-28 98 50)" fill="#292929" />
        <g className="writing-panda-eyes">
          <ellipse cx="58" cy="52" rx="5.7" ry="6.3" fill="#FFF" />
          <ellipse cx="95" cy="52" rx="5.7" ry="6.3" fill="#FFF" />
          <ellipse cx="59.5" cy="53.5" rx="3.6" ry="4.4" fill="#292929" />
          <ellipse cx="93.5" cy="53.5" rx="3.6" ry="4.4" fill="#292929" />
          <circle cx="58" cy="51" r="1.5" fill="#FFF" />
          <circle cx="92" cy="51" r="1.5" fill="#FFF" />
        </g>
        <ellipse cx="43" cy="66" rx="6.5" ry="3" fill="#EAEAEA" />
        <ellipse cx="110" cy="66" rx="6.5" ry="3" fill="#EAEAEA" />
        <path d="M72 63q4-3 9 0-1 5-4.5 5T72 63Z" fill="#292929" />
        <path d="M76.5 67v3m-5-1q2 5 5 1 3 4 5-1" fill="none" stroke="#292929" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      {/* Curved pages and rounded paws replace the rigid desk silhouette. */}
      <path d="M40 92q19-5 39 1 17-7 38-3l13 20q-26-4-45 4-23-7-47-2Z" fill="#DEDEDE" />
      <path d="M41 87q19-4 39 3 17-7 37-4l10 20q-24-3-42 5-21-7-46-4Z" fill="#FFF" stroke="#A9A9A9" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="m80 90 5 21m-34-17q11-1 22 3m-22 2q11-1 22 3m18-6 15-3m-12 8 16-3" fill="none" stroke="#D0D0D0" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M37 76c-8 5-5 15 6 18 7 2 16 0 17-5 2-7-14-16-23-13Z" fill="#292929" />
      <path d="m43 88 1 3m5-2 1 3" stroke="#777" strokeWidth="1.3" strokeLinecap="round" />
      <g className="writing-panda-paw">
        <path d="m99 94 15-34 5 2-15 34-6 5Z" fill="#F7F7F7" stroke="#353535" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="m114 60 2-5q1-2 3-1l1 1q2 1 1 3l-2 4Z" fill="#292929" />
        <path d="m99 97-1 4 4-3Z" fill="#292929" />
        <path d="M113 77c-7-4-17 1-17 8 0 6 9 10 17 6 8-4 9-10 0-14Z" fill="#292929" />
        <path d="m101 84 2 2m3-5 2 2" stroke="#777" strokeWidth="1.3" strokeLinecap="round" />
      </g>
      <path d="M139 78q18-5 14-21" fill="none" stroke="#CDCDCD" strokeWidth="1.4" strokeDasharray="1.5 4" strokeLinecap="round" />
      <g className="writing-panda-letter">
        <rect x="137" y="32" width="27" height="20" rx="4" fill="#FFF" stroke="#777" strokeWidth="1.3" />
        <path d="m138 34 12.5 9L163 34m-24 16 8-8m15 8-8-8" fill="none" stroke="#777" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M150.5 42c-4-4-7 1 0 5 7-4 4-9 0-5Z" fill="#353535" />
      </g>
    </svg>
  )
}
