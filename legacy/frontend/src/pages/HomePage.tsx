import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

const HomePage: React.FC = () => {
  const { isLoggedIn, username } = useAuth();

  return (
    <div className="flex-1 flex flex-col items-center justify-center">
      <h1 className="text-3xl font-bold mb-6">
        Reversing Forum에 오신 것을 환영합니다!
      </h1>

      {isLoggedIn ? (
        <p className="text-lg mb-4">
          <span className="font-medium">{username}</span>님, 환영합니다!
        </p>
      ) : (
        <div className="flex flex-col items-center space-y-4">
          <p className="text-lg mb-2">로그인하여 모든 기능을 이용하세요.</p>
        </div>
      )}
    </div>
  );
};

export default HomePage;
