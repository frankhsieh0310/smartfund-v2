"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function AuthButton({ className }: { className?: string }) {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: controller.signal })
      .then((response) => setAuthenticated(response.ok))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!authenticated) return <Link href="/auth/login" className={className}>登入</Link>;

  return <form action="/auth/logout" method="post"><button type="submit" className={className}>登出</button></form>;
}
