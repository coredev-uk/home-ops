using System.Collections.Frozen;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>The stylesheet, script and font, read once from the assembly and fingerprinted.</summary>
public static class WebAssets
{
    private static readonly FrozenDictionary<string, Asset> Assets = Load();

    /// <summary>Gets the fingerprint of the stylesheet and script together, used to bust caches.</summary>
    public static string Version { get; } = Convert.ToHexStringLower(
        SHA256.HashData(Assets.Values.SelectMany(a => a.Content).ToArray()))[..12];

    public static Asset? Get(string name) => Assets.GetValueOrDefault(name);

    private static FrozenDictionary<string, Asset> Load()
    {
        var assembly = typeof(WebAssets).Assembly;
        var types = new Dictionary<string, string>
        {
            ["hera-tv.css"] = "text/css; charset=utf-8",
            ["hera-tv.js"] = "text/javascript; charset=utf-8",
            ["InterVariable.woff2"] = "font/woff2",
        };

        return types.ToFrozenDictionary(
            t => t.Key,
            t =>
            {
                using var stream = assembly.GetManifestResourceStream(t.Key)
                    ?? throw new InvalidOperationException($"Embedded resource {t.Key} is missing.");
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                return new Asset(memory.ToArray(), t.Value);
            });
    }

    public sealed record Asset(byte[] Content, string ContentType);
}
