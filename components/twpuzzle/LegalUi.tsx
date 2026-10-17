// 2026-10-16：「台股拼圖」公開頁面共用的排版元件。
export function H1({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-2 text-[28px] font-black leading-10 text-white">{children}</h1>;
}
export function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 mt-10 text-[20px] font-bold text-white">{children}</h2>;
}
export function P({ children }: { children: React.ReactNode }) {
  return <p className="my-3">{children}</p>;
}
export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>;
}
export function Mail() {
  return <a href="mailto:contact@smartmatchpilot.com" className="break-all text-[#F5B700] underline underline-offset-4">contact@smartmatchpilot.com</a>;
}
export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-sky-300 underline underline-offset-4">{children}</a>;
}
