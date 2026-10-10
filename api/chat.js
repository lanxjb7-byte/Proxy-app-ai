
const rateLimits = new Map();

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function checkRate(ip) {
  const now = Date.now();
  const old = rateLimits.get(ip);

  if (!old || now - old.start > 60_000) {
    rateLimits.set(ip, { start: now, count: 1 });
    return true;
  }

  if (old.count >= 20) return false;
  old.count++;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Gunakan metode POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return json(res, 500, {
      error: "API belum dikonfigurasi oleh pemilik website."
    });
  }

  const ipHeader = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(ipHeader) ? ipHeader[0] : ipHeader || "unknown")
    .split(",")[0].trim();

  if (!checkRate(ip)) {
    return json(res, 429, {
      error: "Terlalu banyak permintaan. Tunggu satu menit lalu coba lagi."
    });
  }

  try {
    const body = req.body;
    const messages = body && body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json(res, 400, {
        error: "Pesan chat tidak ditemukan."
      });
    }

    if (messages.length > 20) {
      return json(res, 400, {
        error: "Maksimal 20 pesan per permintaan."
      });
    }

    let totalLength = 0;
    const input = [];

    for (const m of messages) {
      if (!m || !["user", "assistant"].includes(m.role)
          || typeof m.content !== "string"
          || !m.content.trim()) {
        return json(res, 400, {
          error: "Format pesan tidak valid."
        });
      }

      if (m.content.length > 8000) {
        return json(res, 400, {
          error: "Pesan terlalu panjang. Maksimal 8.000 karakter."
        });
      }

      totalLength += m.content.length;
      input.push({
        role: m.role,
        content: m.content
      });
    }

    if (totalLength > 25000) {
      return json(res, 400, {
        error: "Total percakapan terlalu panjang."
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          instructions:
            "Kamu adalah PROXY AI, asisten AI yang ramah, cerdas, " +
            "dan membantu. Jawab dalam bahasa yang digunakan pengguna, " +
            "utamakan bahasa Indonesia bila sesuai. Bantu belajar, " +
            "menulis, menjelaskan konsep, dan membuat kode. " +
            "Untuk kode, gunakan blok Markdown dengan label bahasa. " +
            "Berikan jawaban jelas dan jujur. Jangan mengaku telah " +
            "menjalankan kode atau melakukan tindakan yang belum dilakukan.",
          input,
          max_output_tokens: 1600,
          store: false
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "OpenAI API error:",
        response.status,
        data?.error?.code || "unknown"
      );

      if (response.status === 429) {
        return json(res, 429, {
          error: "Batas penggunaan limit. Coba lagi nanti."
        });
      }

      if (response.status === 401 || response.status === 403) {
        return json(res, 502, {
          error: "bermasalah. Periksa konfigurasi."
        });
      }

      return json(res, 502, {
        error: "AI belum dapat memproses permintaan. Coba lagi nanti."
      });
    }

    const reply = (data.output || [])
      .filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!reply) {
      return json(res, 502, {
        error: "AI belum menghasilkan teks. Coba kirim ulang."
      });
    }

    return json(res, 200, { reply });

  } catch (error) {
    console.error("Chat function failed:", error.message);

    return json(res, 500, {
      error: "Terjadi kesalahan server. Coba beberapa saat lagi."
    });
  }
      }
  
