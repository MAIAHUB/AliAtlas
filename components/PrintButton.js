'use client';
export default function PrintButton() {
  return (
    <button className="primary-button" onClick={() => window.print()}>
      Print / Save as PDF
    </button>
  );
}
