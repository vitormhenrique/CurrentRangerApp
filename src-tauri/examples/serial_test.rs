/// Quick standalone test: open the CurrentRanger serial port and print raw data.
/// Run with: cargo run --example serial_test
use std::io::Read;
use std::time::Duration;

const PORT: &str = "/dev/tty.usbmodem1101";
const BAUD: u32 = 230_400;

fn parse_exponent(line: &str) -> Option<f64> {
    let e_pos = line.find('E').or_else(|| line.find('e'))?;
    let mantissa: f64 = line[..e_pos].parse().ok()?;
    let exponent: i32 = line[e_pos + 1..].parse().ok()?;
    Some(mantissa * 10f64.powi(exponent))
}

fn main() {
    println!("=== CurrentRanger Serial + Parser Test ===");
    println!("Opening {} @ {} baud ...", PORT, BAUD);

    let mut port = serialport::new(PORT, BAUD)
        .timeout(Duration::from_millis(100))
        .data_bits(serialport::DataBits::Eight)
        .stop_bits(serialport::StopBits::One)
        .parity(serialport::Parity::None)
        .flow_control(serialport::FlowControl::None)
        .open()
        .expect("Failed to open port");

    println!("Port opened. Waiting 200ms...");
    std::thread::sleep(Duration::from_millis(200));
    let _ = port.clear(serialport::ClearBuffer::Input);

    println!("Sending 'u' to enable USB logging...");
    port.write_all(b"u").expect("write failed");
    port.flush().expect("flush failed");
    std::thread::sleep(Duration::from_millis(300));

    let waiting = port.bytes_to_read().unwrap_or(0);
    if waiting == 0 {
        println!("No data — sending 'u' again...");
        port.write_all(b"u").expect("write failed");
        port.flush().expect("flush failed");
        std::thread::sleep(Duration::from_millis(300));
    }
    let _ = port.clear(serialport::ClearBuffer::Input);

    println!("\n--- Reading + parsing for 3 seconds ---");
    let mut buf = [0u8; 1024];
    let mut line_buf = String::new();
    let start = std::time::Instant::now();
    let mut parsed_count = 0usize;
    let mut failed_count = 0usize;

    while start.elapsed() < Duration::from_secs(3) {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                line_buf.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(nl) = line_buf.find('\n') {
                    let line = line_buf[..nl].trim_end_matches('\r').to_string();
                    line_buf.drain(..=nl);
                    if let Some(amps) = parse_exponent(&line) {
                        parsed_count += 1;
                        if parsed_count <= 10 {
                            println!("  {:>15} -> {:.6} A ({:.3} mA)", line, amps, amps * 1e3);
                        }
                    } else if !line.is_empty() {
                        failed_count += 1;
                        if failed_count <= 5 {
                            println!("  UNPARSED: {:?}", line);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => { println!("Error: {}", e); break; }
        }
    }

    println!("\nParsed: {} samples, Unparsed: {} lines", parsed_count, failed_count);
    println!("=== Done ===");
}
