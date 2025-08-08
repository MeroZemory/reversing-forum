import React from "react";
import { GoogleLogin } from "@react-oauth/google";

interface LoginFormProps {
  onGoogleLogin: (token: string) => void;
}

const LoginForm: React.FC<LoginFormProps> = ({ onGoogleLogin }) => {
  return (
    <div className="flex flex-col items-center">
      {/* 구글 로그인 버튼 */}
      <div className="mt-4 w-full">
        <div className="flex justify-center">
          <GoogleLogin
            onSuccess={(credentialResponse) => {
              if (credentialResponse.credential) {
                onGoogleLogin(credentialResponse.credential);
              }
            }}
            onError={() => {
              console.log("구글 로그인 실패");
            }}
            useOneTap
          />
        </div>
      </div>
    </div>
  );
};

export default LoginForm;
