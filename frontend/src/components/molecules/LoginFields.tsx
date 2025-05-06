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
  <form onSubmit={onSubmit}>
    {/* 아이디 입력 */}
    <input
      name="username"
      placeholder="아이디"
      value={username}
      onChange={onChange}
      autoComplete="username"
    />

    {/* 비밀번호 입력 */}
    <input
      name="password"
      type="password"
      placeholder="비밀번호"
      value={password}
      onChange={onChange}
      autoComplete="current-password"
    />

    {/* 로그인 버튼 */}
    <button type="submit">로그인</button>
  </form>
);

export default LoginFields;
