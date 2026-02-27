import ExternalGamePage from '../shared/ExternalGamePage';

const GAME_KEY = 'podropsquare';

export default function PoDropSquarePage() {
  return (
    <ExternalGamePage
      gameKey={GAME_KEY}
      title="PoDropSquare"
      subtitle="DropSquare game integration. Play inside PoMiniGames and track your results here."
      gameUrl={import.meta.env.VITE_GAME_URL_PODROPSQUARE}
      gameUrlEnvVar="VITE_GAME_URL_PODROPSQUARE"
    />
  );
}
