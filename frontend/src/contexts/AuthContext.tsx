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
  logout: () => void;
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
