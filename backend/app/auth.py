"""Auth dependencies: resolve the bearer token to a User and enforce roles."""

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .database import get_db
from .models import Membership, Role, User
from .security import decode_token

bearer = HTTPBearer(auto_error=False)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = decode_token(creds.credentials)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.get(User, user_id)
    if user is None or user.disabled:
        raise HTTPException(status_code=401, detail="Account not found or disabled")
    return user


def get_current_user_optional(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User | None:
    if creds is None:
        return None
    user_id = decode_token(creds.credentials)
    if user_id is None:
        return None
    user = db.get(User, user_id)
    return user if user and not user.disabled else None


def require_superadmin(user: User = Depends(get_current_user)) -> User:
    if not user.is_superadmin:
        raise HTTPException(status_code=403, detail="Requires platform admin")
    return user


def is_society_admin(db: Session, user: User, society_id: int) -> bool:
    if user.is_superadmin:
        return True
    m = (
        db.query(Membership)
        .filter(
            Membership.user_id == user.id,
            Membership.society_id == society_id,
            Membership.role == Role.admin,
        )
        .first()
    )
    return m is not None


def require_admin(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Any admin: platform superadmin, or a society admin of some society.

    Per-society scoping (admin of *this* resource's society) lands with the
    claims/marketplace work; for now one society is active at a time.
    """
    if user.is_superadmin:
        return user
    has_admin = (
        db.query(Membership)
        .filter(Membership.user_id == user.id, Membership.role == Role.admin)
        .first()
    )
    if has_admin is None:
        raise HTTPException(status_code=403, detail="Requires society admin")
    return user
