
use iroh::{Endpoint, EndpointAddr};
use iroh::endpoint::presets::Minimal;
use tokio::io::AsyncWriteExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize Host Endpoint (A)
    let endpoint_a = Endpoint::builder(Minimal)
        .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>()?)?
        .bind()
        .await?;
        
    let host_node_id = endpoint_a.id();
    let socket_addr = endpoint_a.bound_sockets()[0];
    
    // 2. Initialize Client Endpoint (B)
    let endpoint_b = Endpoint::builder(Minimal)
        .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>()?)?
        .bind()
        .await?;

    // 3. Construct host connection addressing
    let host_addr = EndpointAddr::new(host_node_id)
        .with_ip_addr(socket_addr);

    // 4. Dial Host A from Client B
    let connect_fut = endpoint_b.connect(host_addr, b"ssf");
    
    // 5. Host A accepts incoming request
    let accept_fut = async {
        let incoming = endpoint_a.accept().await.unwrap();
        let accepting = incoming.accept()?;
        let conn = accepting.await?;
        Result::<_, Box<dyn std::error::Error>>::Ok(conn)
    };

    let (conn_b, conn_a) = tokio::try_join!(
        async { connect_fut.await.map_err(|e| e.into()) },
        accept_fut
    )?;

    println!("P2P Connection established successfully!");
    println!("  A sees B's ID: {:?}", conn_a.remote_id());
    println!("  B sees A's ID: {:?}", conn_b.remote_id());

    // 6. Client B opens a bidirectional stream and transmits bytes
    let (mut send_b, mut _recv_b) = conn_b.open_bi().await?;
    send_b.write_all(b"PING: Furlong Sector 7-B Secure connection").await?;
    send_b.shutdown().await?;

    // 7. Host A accepts the stream and reads bytes
    let (mut _send_a, mut recv_a) = conn_a.accept_bi().await?;
    let mut buf = vec![0u8; 100];
    // Wait, let's use the AsyncReadExt method
    let n = recv_a.read(&mut buf).await?.unwrap_or(0);
    let msg = String::from_utf8_lossy(&buf[..n]);
    println!("Host received message over P2P stream: '{}'", msg);

    Ok(())
}
