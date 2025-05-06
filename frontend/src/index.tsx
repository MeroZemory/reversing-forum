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
    <div className="w-full">
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
  <div className="flex justify-between items-center min-h-[5rem] px-10 border-b border-gray-200 relative">
    <div className="font-bold text-2xl">Reversing Forum</div>
    <div className="relative w-[300px] flex justify-end">
      <TopRightAuth />
    </div>
  </div>
);

// 메인 레이아웃 컴포넌트
const App = () => (
  <div className="min-h-screen flex flex-col">
    <Header />
    <div className="flex-1 flex flex-col items-center justify-center">
      <h1 className="text-center">Hello, React + TypeScript + Webpack!</h1>
    </div>
  </div>
);

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <AuthProvider>
    <App />
  </AuthProvider>
);
