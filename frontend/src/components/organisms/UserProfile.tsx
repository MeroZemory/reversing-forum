import React from 'react';

interface UserProfileProps {
  username: string;
  onLogout: () => void;
}

const UserProfile: React.FC<UserProfileProps> = ({ username, onLogout }) => (
  <div>
    <h2>환영합니다, {username}님!</h2>
    <button onClick={onLogout}>로그아웃</button>
  </div>
);

export default UserProfile;