import React, { useState } from 'react';
import LoginFields from '../molecules/LoginFields';

interface LoginFormProps {
  onLogin: (username: string, password: string) => void;
  error?: string;
}

const LoginForm: React.FC<LoginFormProps> = ({ onLogin, error }) => {
  const [form, setForm] = useState({ username: '', password: '' });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin(form.username, form.password);
  };

  return (
    <div>
      <h2>로그인</h2>
      <LoginFields
        username={form.username}
        password={form.password}
        onChange={handleChange}
        onSubmit={handleSubmit}
      />
      {error && <div style={{ color: 'red' }}>{error}</div>}
    </div>
  );
};

export default LoginForm;