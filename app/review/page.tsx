// app/review/layout.tsx
// Review Mode 獨立 layout，覆蓋根 layout 的背景設定

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
    return (
      <div style={{ background: "#0a0f1e", minHeight: "100vh" }}>
        {children}
      </div>
    );
  }