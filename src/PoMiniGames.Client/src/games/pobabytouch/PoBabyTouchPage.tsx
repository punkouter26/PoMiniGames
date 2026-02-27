import ExternalGamePage from '../shared/ExternalGamePage';

const GAME_KEY = 'pobabytouch';

export default function PoBabyTouchPage() {
  return (
    <ExternalGamePage
      gameKey={GAME_KEY}
      title="PoBabyTouch"
      subtitle="BabyTouch game integration. Play inside PoMiniGames and track your results here."
      gameUrl={import.meta.env.VITE_GAME_URL_POBABYTOUCH}
      gameUrlEnvVar="VITE_GAME_URL_POBABYTOUCH"
    />
  );
}
