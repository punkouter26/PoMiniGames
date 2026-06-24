using Xunit;

// Browser E2E is heavy: each test boots a Kestrel host, an Azurite container, a Chromium
// instance, and waits for the Blazor WASM runtime to download and start. Running the two
// collections (default + mock-data) in parallel starves CPU/Docker and makes WASM-boot
// waits flaky. Serialize the whole assembly so each test gets the full machine.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
