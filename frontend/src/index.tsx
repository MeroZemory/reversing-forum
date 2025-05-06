import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import Header from "./components/organisms/Header";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import "./styles/tailwind.css";

// 레이아웃 컴포넌트
const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen flex flex-col">
    <Header />
    {children}
  </div>
);

// 메인 앱 컴포넌트
const App = () => (
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
        {/* 추후 다른 라우트 추가 가능 */}
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
