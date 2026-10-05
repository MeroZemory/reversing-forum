"use client";
import { useState } from "react";
import styles from "./post-reading.module.css";
export function PostShare({ url }: { url: string }) {
  const [message, setMessage] = useState("");
  return (
    <span className={styles.share}>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setMessage("링크를 복사했어요.");
          } catch {
            setMessage("주소창의 링크를 복사해 주세요.");
          }
        }}
      >
        링크 복사
      </button>
      <span role="status">{message}</span>
    </span>
  );
}
