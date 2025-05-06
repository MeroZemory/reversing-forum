import React, { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import LoginForm from "../components/LoginForm";

const LoginPage: React.FC = () => {
  const { isLoggedIn, login, error } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [message, setMessage] = useState<string | null>(null);

  // 이전 페이지 정보 (state에서 가져오거나 기본값으로 홈)
  const from = location.state?.from?.pathname || "/";

  // 회원가입 완료 메시지 설정
  useEffect(() => {
    if (location.state?.message) {
      setMessage(location.state.message);
      // 브라우저 히스토리에서 메시지 제거
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  // 이미 로그인되어 있으면 이전 페이지로 리디렉션
  useEffect(() => {
    if (isLoggedIn) {
      navigate(from, { replace: true });
    }
  }, [isLoggedIn, navigate, from]);

  const handleRegisterClick = () => {
    navigate("/register");
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
      <div className="w-full max-w-md p-8 space-y-8 bg-white rounded-lg shadow-md">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">로그인</h1>
          <p className="mt-2 text-sm text-gray-600">
            계정에 로그인하여 Reversing Forum을 이용하세요
          </p>
        </div>

        {message && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded text-sm">
            {message}
          </div>
        )}

        <LoginForm
          onLogin={login}
          error={error || undefined}
          onRegisterClick={handleRegisterClick}
        />

        <div className="text-center mt-4">
          <button
            onClick={() => navigate(-1)}
            className="text-sm text-gray-600 hover:text-gray-800"
          >
            뒤로 가기
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
