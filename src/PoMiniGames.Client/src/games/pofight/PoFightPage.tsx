import ExternalGamePage from '../shared/ExternalGamePage';

const GAME_KEY = 'pofight';

export default function PoFightPage() {
  return (
    <ExternalGamePage
      gameKey={GAME_KEY}
      title="PoFight"
      subtitle="Fight game integration. Play inside PoMiniGames and track your results here."
      gameUrl={import.meta.env.VITE_GAME_URL_POFIGHT}
      gameUrlEnvVar="VITE_GAME_URL_POFIGHT"
    />
  );
}
