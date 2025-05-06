import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { GoogleOAuthProvider } from "@react-oauth/google";
import Header from "./components/Header";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
// import RegisterPage from "./pages/RegisterPage"; // 회원가입 페이지 제거
import "./styles/tailwind.css";

// Google Client ID - 환경 변수 사용
const GOOGLE_CLIENT_ID =
  process.env.REACT_APP_GOOGLE_CLIENT_ID || "your-google-client-id";

// 레이아웃 컴포넌트
const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen flex flex-col">
    <Header />
    {children}
  </div>
);

// 메인 앱 컴포넌트
const App = () => (
  <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/"
            element={
              <Layout>
                <HomePage />
              </Layout>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          {/* RegisterPage 라우트 제거 */}
          {/* <Route path="/register" element={<RegisterPage />} /> */}
          <Route path="/auth/google/callback" element={<LoginPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </GoogleOAuthProvider>
);

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
