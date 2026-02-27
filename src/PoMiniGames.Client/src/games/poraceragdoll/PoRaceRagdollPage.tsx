import ExternalGamePage from '../shared/ExternalGamePage';

const GAME_KEY = 'poraceragdoll';

export default function PoRaceRagdollPage() {
  return (
    <ExternalGamePage
      gameKey={GAME_KEY}
      title="PoRaceRagdoll"
      subtitle="Ragdoll racing integration. Play inside PoMiniGames and track your results here."
      gameUrl={import.meta.env.VITE_GAME_URL_PORACERAGDOLL}
      gameUrlEnvVar="VITE_GAME_URL_PORACERAGDOLL"
    />
  );
}
