import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import UserProfile from "./UserProfile";

// 상단 레이아웃 컴포넌트
const Header: React.FC = () => {
  const { isLoggedIn, username, logout } = useAuth();

  return (
    <div className="flex justify-between items-center min-h-[5rem] px-10 border-b border-gray-200 relative">
      <div className="font-bold text-2xl">
        <Link to="/" className="hover:text-blue-600 transition-colors">
          Reversing Forum
        </Link>
      </div>
      <div className="relative flex justify-end">
        {isLoggedIn ? (
          <UserProfile username={username!} onLogout={logout} />
        ) : (
          <Link
            to="/login"
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors duration-300"
          >
            로그인
          </Link>
        )}
      </div>
    </div>
  );
};

export default Header;
