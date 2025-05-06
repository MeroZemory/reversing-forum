import React from "react";
// import Input from '../atoms/Input';
// import Button from '../atoms/Button';

interface LoginFieldsProps {
  username: string;
  password: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
}

const LoginFields: React.FC<LoginFieldsProps> = ({
  username,
  password,
  onChange,
  onSubmit,
}) => (
  <form onSubmit={onSubmit} className="flex items-center w-full">
    <div className="flex flex-col space-y-2 mr-2">
      {/* 아이디 입력 */}
      <input
        name="username"
        placeholder="아이디"
        value={username}
        onChange={onChange}
        autoComplete="username"
        className="px-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
      />

      {/* 비밀번호 입력 */}
      <input
        name="password"
        type="password"
        placeholder="비밀번호"
        value={password}
        onChange={onChange}
        autoComplete="current-password"
        className="px-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
      />
    </div>

    {/* 로그인 버튼 */}
    <button
      type="submit"
      className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-5 px-4 rounded-lg transition-colors duration-300 shadow-sm hover:shadow-md h-full"
    >
      로그인
    </button>
  </form>
);

export default LoginFields;
