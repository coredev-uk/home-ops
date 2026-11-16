using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Serves the web assets and the client-facing settings. The login page loads them too, so no auth.</summary>
[ApiController]
[AllowAnonymous]
[Route("HeraTV")]
public class HeraTvController : ControllerBase
{
    [HttpGet("{name}")]
    public IActionResult GetAsset([FromRoute] string name)
    {
        var asset = WebAssets.Get(name);
        if (asset is null)
        {
            return NotFound();
        }

        // The page references assets with ?v=<fingerprint>, so those URLs never change content.
        Response.Headers.CacheControl = Request.Query.ContainsKey("v")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400";
        return File(asset.Content, asset.ContentType);
    }

    [HttpGet("config")]
    public IActionResult GetConfig()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        Response.Headers.CacheControl = "no-cache";
        return Ok(new
        {
            heroItemCount = Math.Clamp(config.HeroItemCount, 1, 20),
            heroIntervalSeconds = Math.Clamp(config.HeroIntervalSeconds, 4, 60),
        });
    }
}
