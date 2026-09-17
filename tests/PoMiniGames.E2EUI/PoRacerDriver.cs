using System.Diagnostics;
using System.Text.Json;
using Microsoft.Playwright;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.E2EUI;

/// <summary>Observes real server frames and drives through browser keyboard input only.</summary>
internal sealed class PoRacerDriver
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public PoRacerRaceSnapshot? Snapshot { get; private set; }
    public PoRacerStaticWorld? World { get; private set; }
    public PoRacerFinalResult? Result { get; private set; }
    public int? LocalId { get; private set; }
    public bool SawCountdown { get; private set; }
    public bool MovedDuringCountdown { get; private set; }

    public PoRacerDriver(IPage page)
    {
        page.WebSocket += (_, socket) =>
        {
            if (!socket.Url.Contains("race-hub", StringComparison.Ordinal)) return;
            socket.FrameReceived += (_, frame) =>
            {
                foreach (var text in (frame.Text ?? "").Split('\x1e', StringSplitOptions.RemoveEmptyEntries))
                {
                    using var doc = JsonDocument.Parse(text);
                    var message = doc.RootElement;
                    if (message.TryGetProperty("target", out var target))
                    {
                        if (target.GetString() == "raceSnapshot") Accept(message.GetProperty("arguments")[0]);
                        if (target.GetString() == "raceFinished") Result = message.GetProperty("arguments")[0].Deserialize<PoRacerFinalResult>(Json);
                    }
                    else if (message.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.Object && result.TryGetProperty("cars", out var cars)) Accept(result);
                }
            };
        };
    }

    private void Accept(JsonElement element)
    {
        var snapshot = element.Deserialize<PoRacerRaceSnapshot>(Json)!;
        if (snapshot.Static is { } world) World = world;
        if (snapshot.LocalCarId is { } id) LocalId = id;
        if (!snapshot.Started)
        {
            SawCountdown = true;
            MovedDuringCountdown |= snapshot.Cars.Any(c => c.Speed != 0);
        }
        Snapshot = snapshot;
    }

    public void Reset() { Snapshot = null; World = null; Result = null; LocalId = null; SawCountdown = MovedDuringCountdown = false; }

    public async Task DriveAsync(IPage page, string track, bool drive = true)
    {
        var clock = Stopwatch.StartNew();
        var held = new HashSet<string>();
        double previousHeading = 0, previousTime = -1, rate = 0;
        int capturedLap = 0;
        var lastLog = -10.0;
        Directory.CreateDirectory("artifacts");
        try
        {
            while (Result is null && clock.Elapsed < TimeSpan.FromSeconds(195))
            {
                var snapshot = Snapshot;
                var car = snapshot?.Cars.FirstOrDefault(c => c.Id == LocalId);
                if (car is null || World is null) { await Task.Delay(50); continue; }
                var next = new HashSet<string>();
                if (drive && !car.Finished)
                {
                    var xy = World.CenterXY;
                    int n = xy.Count / 2;
                    int index = Math.Clamp((int)(car.LapProgress * n), 0, n - 1);
                    double fraction = car.LapProgress * n - index;
                    double distance = 145, tx = car.X, ty = car.Y;
                    for (int step = 0; step < n; step++)
                    {
                        int j = (index + 1) % n;
                        double dx = xy[j * 2] - xy[index * 2], dy = xy[j * 2 + 1] - xy[index * 2 + 1];
                        double length = Math.Sqrt(dx * dx + dy * dy), available = length * (1 - fraction);
                        if (distance <= available)
                        {
                            fraction += distance / length;
                            tx = xy[index * 2] + fraction * dx; ty = xy[index * 2 + 1] + fraction * dy;
                            break;
                        }
                        distance -= available; index = j; fraction = 0;
                    }
                    var diff = Angle(Math.Atan2(ty - car.Y, tx - car.X) - car.Heading);
                    if (snapshot!.ServerTimeMs > previousTime)
                    {
                        rate = previousTime < 0 ? 0 : Angle(car.Heading - previousHeading) / ((snapshot.ServerTimeMs - previousTime) / 1000);
                        previousTime = snapshot.ServerTimeMs; previousHeading = car.Heading;
                    }
                    double turn = diff - rate * 0.16;
                    double targetSpeed = Math.Abs(diff) > 0.32 ? 235 : 300;
                    if (car.Speed < targetSpeed - 3) next.Add("ArrowUp");
                    if (car.Speed > targetSpeed + 12) next.Add("ArrowDown");
                    if (turn > 0.035) next.Add("ArrowRight");
                    if (turn < -0.035) next.Add("ArrowLeft");
                }
                foreach (var key in held.Except(next)) await page.Keyboard.UpAsync(key);
                foreach (var key in next.Except(held)) await page.Keyboard.DownAsync(key);
                held = next;
                if (car.Lap != capturedLap)
                {
                    capturedLap = car.Lap;
                    await page.ScreenshotAsync(new() { Path = $"artifacts/poracer-{track}-lap-{car.Lap}.png" });
                }
                if (clock.Elapsed.TotalSeconds - lastLog > 5)
                {
                    lastLog = clock.Elapsed.TotalSeconds;
                    await File.AppendAllTextAsync($"artifacts/poracer-{track}-drive.log", $"{snapshot!.ElapsedRaceTime:F1}s lap={car.Lap} progress={car.LapProgress:F2} speed={car.Speed:F0} position={car.Position}\n");
                }
                await Task.Delay(50);
            }
            Result.Should().NotBeNull("the race must deliver a final result, including when cars do not finish");
        }
        finally { foreach (var key in held) await page.Keyboard.UpAsync(key); }
    }

    private static double Angle(double value) => Math.Atan2(Math.Sin(value), Math.Cos(value));
}
