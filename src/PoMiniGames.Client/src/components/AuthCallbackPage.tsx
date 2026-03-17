import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { isLoading, consumeReturnUrl } = useAuth();

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const returnUrl = consumeReturnUrl() ?? '/';
    navigate(returnUrl, { replace: true });
  }, [consumeReturnUrl, isLoading, navigate]);

  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--color-text-secondary)' }}>
        <Loader2 size={18} className="thinking-indicator" />
        Completing Microsoft sign-in...
      </div>
    </div>
  );
}