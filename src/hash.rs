use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Result as IoResult};
use std::path::Path;

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    to_hex(&hasher.finalize())
}

pub fn sha256_file(path: &Path) -> IoResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn known_vectors() {
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_bytes_handles_various_inputs() {
        // 单字节
        assert_eq!(
            sha256_bytes(b"a"),
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
        );

        // 较长文本
        assert_eq!(
            sha256_bytes(b"The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn sha256_bytes_produces_64_char_hex() {
        let hash = sha256_bytes(b"test data");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn sha256_bytes_is_deterministic() {
        let data = b"deterministic test";
        let hash1 = sha256_bytes(data);
        let hash2 = sha256_bytes(data);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn sha256_file_hashes_file_content() -> std::io::Result<()> {
        let mut temp_file = NamedTempFile::new()?;
        temp_file.write_all(b"abc")?;
        temp_file.flush()?;

        let hash = sha256_file(temp_file.path())?;
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        Ok(())
    }

    #[test]
    fn sha256_file_handles_empty_file() -> std::io::Result<()> {
        let temp_file = NamedTempFile::new()?;

        let hash = sha256_file(temp_file.path())?;
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        Ok(())
    }

    #[test]
    fn sha256_file_handles_large_file() -> std::io::Result<()> {
        let mut temp_file = NamedTempFile::new()?;
        // 写入超过缓冲区大小的数据（64KB 缓冲区）
        let data = vec![b'x'; 128 * 1024];
        temp_file.write_all(&data)?;
        temp_file.flush()?;

        let hash = sha256_file(temp_file.path())?;
        // 验证哈希值是 64 字符的十六进制
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));

        Ok(())
    }

    #[test]
    fn to_hex_converts_bytes_correctly() {
        let bytes = [0x00, 0x0f, 0xff, 0xa5];
        let hex = to_hex(&bytes);
        assert_eq!(hex, "000fffa5");
    }
}
