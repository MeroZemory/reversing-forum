import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
} from "react";
import axios from "axios";

interface AuthContextType {
  isLoggedIn: boolean;
  username: string | null;
  // login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  // register: (
  //   username: string,
  //   email: string,
  //   password: string
  // ) => Promise<void>;
  googleLogin: (token: string) => Promise<void>;
  error: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // localStorage에서 로그인 상태 복원
    const savedUser = localStorage.getItem("username");
    if (savedUser) {
      setIsLoggedIn(true);
      setUsername(savedUser);
    }
  }, []);

  /*
  const login = async (username: string, password: string) => {
    try {
      setError(null);
      const response = await axios.post("/api/login", { username, password });
      setIsLoggedIn(true);
      setUsername(response.data.username);
      localStorage.setItem("username", response.data.username);
    } catch (err) {
      setError("아이디 또는 비밀번호가 올바르지 않습니다.");
    }
  };

  const register = async (
    username: string,
    email: string,
    password: string
  ) => {
    try {
      setError(null);
      await axios.post("/api/register", { username, email, password });
      return Promise.resolve();
    } catch (err: any) {
      setError(
        err.response?.data?.detail || "회원가입 중 오류가 발생했습니다."
      );
      return Promise.reject(err);
    }
  };
  */

  const googleLogin = async (token: string) => {
    try {
      setError(null);
      const response = await axios.post("/api/auth/google", { token });
      setIsLoggedIn(true);
      setUsername(response.data.user.username);
      localStorage.setItem("username", response.data.user.username);
      return Promise.resolve();
    } catch (err: any) {
      setError(
        err.response?.data?.detail || "구글 로그인 중 오류가 발생했습니다."
      );
      return Promise.reject(err);
    }
  };

  const logout = () => {
    setIsLoggedIn(false);
    setUsername(null);
    setError(null);
    localStorage.removeItem("username");
  };

  return (
    <AuthContext.Provider
      value={{ isLoggedIn, username, googleLogin, logout, error }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context)
    throw new Error("useAuth는 AuthProvider 내에서만 사용해야 합니다.");
  return context;
};
