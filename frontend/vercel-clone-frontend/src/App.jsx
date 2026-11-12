import { useState, useEffect } from "react";
import axios from "axios";
import io from "socket.io-client";

const socket = io(import.meta.env.VITE_SOCKET_URL); // socket server

function App() {
  const [gitURL, setGitURL] = useState("");
  const [slug, setSlug] = useState("");
  const [logs, setLogs] = useState([]);
  const [project, setProject] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLogs([]);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}/project`, {
        gitURL,
        slug: slug.trim() === "" ? undefined : slug,
      });

      const data = res.data;
      setProject(data.data);

      // subscribe to that project logs
      socket.emit("subscribe", `logs:${data.data.projectSlug}`);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    socket.on("message", (msg) => {
      setLogs((prev) => [...prev, msg]);
    });
    return () => {
      socket.off("message");
    };
  }, []);

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>🚀 Deploy Project</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Enter GitHub Repo URL"
          value={gitURL}
          onChange={(e) => setGitURL(e.target.value)}
          style={{ padding: "0.5rem", width: "300px" }}
        />
        <input
          type="text"
          placeholder="Custom Slug (optional)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          style={{ padding: "0.5rem", marginLeft: "1rem", width: "200px" }}
          />
        <button
          type="submit"
          style={{ marginLeft: "1rem", padding: "0.5rem 1rem" }}
        >
          Deploy
        </button>
      </form>

      {project && (
        <div style={{ marginTop: "1rem" }}>
          <p>
            <strong>Project Slug:</strong> {project.projectSlug}
          </p>
          <p>
            <strong>Preview URL:</strong>{" "}
            <a href={project.url} target="_blank" rel="noreferrer">
              {project.url}
            </a>
          </p>
        </div>
      )}

      <div
        style={{
          background: "#111",
          color: "#0f0",
          marginTop: "2rem",
          padding: "1rem",
          borderRadius: "8px",
          height: "300px",
          overflowY: "auto",
        }}
      >
        <h3>📜 Build Logs</h3>
        {logs.map((log, i) => (
          <pre key={i}>{log}</pre>
        ))}
      </div>
    </div>
  );
}

export default App;
