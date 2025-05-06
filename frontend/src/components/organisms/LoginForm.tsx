import React, { useState } from "react";

interface LoginFormProps {
  onLogin: (username: string, password: string) => void;
  error?: string;
  onRegisterClick?: () => void;
}

const LoginForm: React.FC<LoginFormProps> = ({
  onLogin,
  error,
  onRegisterClick,
}) => {
  const [form, setForm] = useState({ username: "", password: "" });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin(form.username, form.password);
  };

  return (
    <div className="flex flex-col">
      <form onSubmit={handleSubmit} className="flex w-full">
        <div className="flex flex-col space-y-2 w-full">
          {/* 아이디 입력 */}
          <input
            name="username"
            placeholder="아이디"
            value={form.username}
            onChange={handleChange}
            autoComplete="username"
            className="px-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
          />

          {/* 비밀번호 입력 */}
          <input
            name="password"
            type="password"
            placeholder="비밀번호"
            value={form.password}
            onChange={handleChange}
            autoComplete="current-password"
            className="px-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
          />

          {error && <div className="text-red-500 text-xs mt-1">{error}</div>}

          {/* 로그인 버튼 */}
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors duration-300 shadow-sm hover:shadow-md mt-1"
          >
            로그인
          </button>

          {/* 회원가입 버튼 */}
          <button
            type="button"
            onClick={onRegisterClick}
            className="text-blue-600 hover:text-blue-800 text-xs font-medium py-1 self-center mt-1"
          >
            회원가입
          </button>
        </div>
      </form>
    </div>
  );
};

export default LoginForm;
