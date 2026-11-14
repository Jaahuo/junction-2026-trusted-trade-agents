import os
from pathlib import Path
import sqlite3
import uuid


def migrate(database, email, password):
    email = email.strip().lower()
    if not database.exists():
        return
    if not email or not password or (email == "admin@localhost" and password == "admin"):
        raise ValueError("Set a private operator email and password before enabling login.")
    import bcrypt
    from argon2 import PasswordHasher
    from argon2.exceptions import VerificationError

    with sqlite3.connect(database) as connection:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth'").fetchone():
            return
        row = connection.execute(
            'SELECT auth.id, auth.password FROM auth JOIN user ON user.id=auth.id '
            "WHERE auth.email='admin@localhost' AND user.role='admin'"
        ).fetchone()
        if row is None:
            return
        user_id, encoded = row
        try:
            default_password = (PasswordHasher().verify(encoded, "admin") if encoded.startswith("$argon2")
                                else bcrypt.checkpw(b"admin", encoded.encode()))
        except (VerificationError, ValueError):
            default_password = False
        if not default_password:
            return
        conflict = connection.execute('SELECT id FROM user WHERE lower(email)=? AND id<>?', (email, user_id)).fetchone()
        if conflict:
            raise ValueError("The operator email belongs to another account. Choose a different email.")
        backup = database.with_name(database.name + ".before-auth")
        if backup.exists():
            raise ValueError("An auth migration backup already exists. Inspect it before retrying migration.")
        with sqlite3.connect(backup) as destination:
            connection.backup(destination)
        backup.chmod(0o600)
        connection.execute('UPDATE auth SET email=?, password=?, session_stamp=? WHERE id=?',
                           (email, PasswordHasher().hash(password), str(uuid.uuid4()), user_id))
        connection.execute('UPDATE user SET email=? WHERE id=?', (email, user_id))
        print("Migrated the login-disabled operator account. Account ID and chat data are unchanged.")


if __name__ == "__main__":
    migrate(Path("/app/backend/data/webui.db"), os.environ["WEBUI_ADMIN_EMAIL"], os.environ["WEBUI_ADMIN_PASSWORD"])
