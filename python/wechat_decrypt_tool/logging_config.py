"""The worker protocol must never contain core logs, paths or key material."""
import logging

_logger = logging.getLogger('wechat-decrypt-isolated')
_logger.addHandler(logging.NullHandler())
_logger.propagate = False
_logger.setLevel(logging.CRITICAL + 1)

def get_logger(name):
    return _logger

def setup_logging(*args, **kwargs):
    return None
