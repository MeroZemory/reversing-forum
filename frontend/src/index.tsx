import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import LoginForm from "./components/organisms/LoginForm";
import UserProfile from "./components/organisms/UserProfile";
import "./styles/tailwind.css";

// 우상단 로그인/유저 정보 표시용 래퍼 컴포넌트
const TopRightAuth: React.FC = () => {
  const { isLoggedIn, username, login, logout, error } = useAuth();
  return (
    <div style={{ width: "100%" }}>
      {isLoggedIn ? (
        <UserProfile username={username!} onLogout={logout} />
      ) : (
        <LoginForm onLogin={login} error={error || undefined} />
      )}
    </div>
  );
};

// 상단 레이아웃 컴포넌트
const Header: React.FC = () => (
  <div style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    height: 80,
    padding: "0 40px",
    borderBottom: "1px solid #eee",
    position: "relative"
  }}>
  <div style={{ fontWeight: "bold", fontSize: 24 }}>Reversing Forum</div>
  <div style={{ position: "relative", width: 300, display: "flex", justifyContent: "flex-end" }}>
      <TopRightAuth />
    </div>
  </div>
);

// 메인 레이아웃 컴포넌트
const App = () => (
  <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
    <Header />
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <h1 style={{ textAlign: "center", marginTop: 100 }}>Hello, React + TypeScript + Webpack!</h1>
    </div>
  </div>
);

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <AuthProvider>
    <App />
  </AuthProvider>
);
